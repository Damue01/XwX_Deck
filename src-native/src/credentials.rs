//! Deck-owned documents use private files. OS vault access is limited to
//! one-time recovery of the previous encrypted format and explicit diagnostics.
//! Crypto API: https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use std::sync::{OnceLock, RwLock};
use zeroize::Zeroizing;
const SERVICE: &str = "app.xwxdeck.desktop.credentials";
const VALIDATION_SERVICE: &str = "app.xwxdeck.validation.credentials";
struct Scope {
    root: PathBuf,
    id: String,
    service: &'static str,
    key: Zeroizing<Vec<u8>>,
    encrypt: bool,
}
static SCOPES: OnceLock<RwLock<Vec<Scope>>> = OnceLock::new();
fn registry() -> &'static RwLock<Vec<Scope>> {
    SCOPES.get_or_init(|| RwLock::new(vec![]))
}
pub(super) fn protected(relative: &str) -> bool {
    if let Some(original) = relative.strip_prefix("credential-migration-backups/") {
        return protected(original);
    }
    if relative.starts_with("reset-backup-") && relative.ends_with("/settings.json") {
        return true;
    }
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() == 3
        && ((parts[0] == "grok-accounts"
            && parts[1].starts_with("grok-")
            && parts[2] == "auth.json")
            || (parts[0] == "claude-subscription-homes"
                && parts[1].starts_with("claude-")
                && parts[2] == ".credentials.json"))
    {
        return true;
    }
    [
        "settings.json",
        "settings-before-native-migration.json",
        "subscription-accounts.json",
        "official-chatgpt-accounts.json",
        "copilot-accounts.json",
        "cursor-accounts.json",
        "claude-subscription-accounts.json",
        "codex-direct.json",
        "claude-direct.json",
        "gateway-recovery.json",
        "desktop-ledger.json",
        "desktop-sync-ledger.json",
        "desktop-recovery.json",
        "codex-local-proxy-suspension.json",
        "codex-direct-config-state.json",
        "codex-direct-restore.json",
        "compatible-image-gen.json",
        "claude-desktop-sync-state.json",
        "gateway/bootstrap.json",
        "gateway/control.token",
        "gateway/client-fallbacks.json",
    ]
    .contains(&relative)
        || relative.starts_with("trace-client-backups/") && relative.ends_with(".json")
        || relative.starts_with("legacy-recovery-") && relative.ends_with(".json")
        || relative.starts_with("client-repair-") && relative.ends_with(".json")
        || relative.starts_with("client-wiring-") && relative.ends_with(".json")
        || relative.starts_with("settings-backup-") && relative.ends_with(".json")
        || relative.starts_with("gateway-recovered-") && relative.ends_with(".json")
        || relative.starts_with("codex/config-backup-") && relative.ends_with(".toml")
        || relative.starts_with("codex/backup-") && relative.ends_with(".toml")
}
fn relative(scope: &Scope, path: &Path) -> Option<String> {
    path.strip_prefix(&scope.root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}
fn envelope(value: &str) -> Option<Value> {
    serde_json::from_str::<Value>(value)
        .ok()
        .filter(|v| v["nativeEncryptedDocument"] == 1)
}
fn aad(scope: &Scope, document: &str) -> String {
    format!("{}/v1/{}/{document}", scope.service, scope.id)
}
pub(super) fn decode(path: &Path, value: String) -> Result<String> {
    let Some(document) = envelope(&value) else {
        return Ok(value);
    };
    let scopes = registry().read().map_err(|_| "凭据存储暂不可用")?;
    let scope = scopes
        .iter()
        .find(|s| path.starts_with(&s.root))
        .ok_or("加密配置未连接安全存储，原文件已保留")?;
    let name = relative(scope, path).ok_or("安全配置路径无效")?;
    if document["vaultId"] != scope.id || document["documentId"] != name || !protected(&name) {
        return Err("加密配置身份或路径不匹配，未读取或覆盖".into());
    }
    let nonce = STANDARD
        .decode(text(&document, "nonce"))
        .map_err(|_| "加密配置 nonce 损坏，原文件已保留")?;
    if nonce.len() != 24 {
        return Err("加密配置 nonce 长度无效，原文件已保留".into());
    }
    if value.len() > 64 * 1024 * 1024 {
        return Err("加密配置超过读取上限，原文件已保留".into());
    }
    let ciphertext = STANDARD
        .decode(text(&document, "ciphertext"))
        .map_err(|_| "加密配置密文损坏，原文件已保留")?;
    let cipher = XChaCha20Poly1305::new_from_slice(&scope.key).map_err(|_| "安全存储密钥无效")?;
    let decrypted = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad(scope, &name).as_bytes(),
                },
            )
            .map_err(|_| "加密配置认证失败，未重置或覆盖；请恢复原备份和系统凭据")?,
    );
    String::from_utf8(decrypted.to_vec()).map_err(|_| "安全配置不是 UTF-8".into())
}
pub(super) fn encode(path: &Path, value: &str) -> Result<String> {
    let scopes = registry().read().map_err(|_| "凭据存储暂不可用")?;
    let Some(scope) = scopes.iter().find(|s| path.starts_with(&s.root)) else {
        return Ok(value.into());
    };
    let name = relative(scope, path).ok_or("安全配置路径无效")?;
    if !scope.encrypt || !protected(&name) {
        return Ok(value.into());
    }
    let mut nonce = [0; 24];
    getrandom::fill(&mut nonce).map_err(|_| "系统随机数不可用，未写入凭据")?;
    let cipher = XChaCha20Poly1305::new_from_slice(&scope.key).map_err(|_| "安全存储密钥无效")?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: value.as_bytes(),
                aad: aad(scope, &name).as_bytes(),
            },
        )
        .map_err(|_| "凭据加密失败，未写入")?;
    serde_json::to_string(&json!({"nativeEncryptedDocument":1,"vaultId":scope.id,"documentId":name,"nonce":STANDARD.encode(nonce),"ciphertext":STANDARD.encode(ciphertext)})).map_err(|_|"凭据封装失败".into())
}
fn raw(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err("安全存储路径不是普通文件，原位置已保留".into())
        }
        Ok(meta) if meta.len() > 64 * 1024 * 1024 => {
            Err("安全存储文件超过读取上限，原文件已保留".into())
        }
        Ok(_) => fs::read(path).map(Some).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn raw_write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "无法创建安全存储记录，原文件已保留")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(err)?;
    }
    private_permissions(path, false)?;
    file.write_all(bytes).map_err(err)?;
    file.sync_all().map_err(err)
}

const PRIVATE_MARKER: &str = "native-credential-storage.json";
#[cfg(target_os = "macos")]
pub(super) fn webcrypto_private_key(
    root: &Path,
    _isolated: bool,
    _interactive: bool,
) -> Result<Zeroizing<Vec<u8>>> {
    let path = root.join("native-webcrypto-key.json");
    if let Some(bytes) = raw(&path)? {
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "网页本地密钥文件损坏，原文件已保留")?;
        let key = Zeroizing::new(
            STANDARD
                .decode(text(&value, "key"))
                .map_err(|_| "网页本地密钥无效，原文件已保留")?,
        );
        if value["version"] != 1 || key.len() != 16 {
            return Err("网页本地密钥版本或长度无效，原文件已保留".into());
        }
        private_permissions(&path, false)?;
        return Ok(key);
    }
    let mut key = Zeroizing::new(vec![0u8; 16]);
    // A new xwxdeck profile owns a fresh local key. Never probe WebKit's legacy
    // Keychain account: that may prompt even with interaction disabled.
    getrandom::fill(&mut key).map_err(|_| "无法创建网页本地密钥，未改写登录数据")?;
    private_parents(root, &path)?;
    let document = Zeroizing::new(json!({"version":1,"key":STANDARD.encode(&*key)}).to_string());
    write(&path, &document)?;
    private_permissions(&path, false)?;
    if raw(&path)?.as_deref() != Some(document.as_bytes()) {
        return Err("网页本地密钥回读失败，原登录数据已保留".into());
    }
    Ok(key)
}
static PRIVATE_ROOTS: OnceLock<RwLock<Vec<PathBuf>>> = OnceLock::new();
fn private_roots() -> &'static RwLock<Vec<PathBuf>> {
    PRIVATE_ROOTS.get_or_init(|| RwLock::new(vec![]))
}

/// Only application-owned paths are passed here, never the official client's home.
pub(super) fn private_permissions(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if metadata.file_type().is_symlink()
        || directory != metadata.is_dir()
        || (!directory && !metadata.is_file())
    {
        return Err("应用私有路径不是预期的普通文件或目录，原位置已保留".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
        .map_err(err)?;
    }
    #[cfg(windows)]
    windows_private_permissions(path)?;
    Ok(())
}

#[cfg(windows)]
fn windows_private_permissions(path: &Path) -> Result<()> {
    // Owner Rights grants the file owner full access, including for inherited
    // children. A protected DACL removes broader inherited profile/portable ACLs.
    // https://learn.microsoft.com/en-us/windows/win32/secauthz/sid-strings
    // https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr::null_mut};
    #[link(name = "Advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            source: *const u16,
            revision: u32,
            output: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn GetSecurityDescriptorDacl(
            descriptor: *const c_void,
            present: *mut i32,
            dacl: *mut *mut c_void,
            defaulted: *mut i32,
        ) -> i32;
        fn SetNamedSecurityInfoW(
            name: *const u16,
            kind: u32,
            information: u32,
            owner: *mut c_void,
            group: *mut c_void,
            dacl: *mut c_void,
            sacl: *mut c_void,
        ) -> u32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = null_mut();
    let mut dacl = null_mut();
    let (mut present, mut defaulted) = (0, 0);
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err("无法构造应用私有目录权限，未写入凭据".into());
        }
        let valid = GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            != 0
            && present != 0
            && !dacl.is_null();
        let result = if valid {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                1,
                0x80000004,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        } else {
            1
        };
        LocalFree(descriptor);
        if result != 0 {
            return Err(format!(
                "无法设置应用私有文件权限（Windows 错误码 {result}，路径长度 {}），未写入凭据",
                name.len() - 1
            ));
        }
    }
    Ok(())
}

fn private_parents(root: &Path, path: &Path) -> Result<()> {
    let parent = path.parent().ok_or("凭据路径无效")?;
    if !parent.starts_with(root) {
        return Err("凭据路径不在应用目录内".into());
    }
    // Check ancestors before creating anything so a link cannot redirect mkdir/chmod.
    for ancestor in parent.ancestors().take_while(|p| p.starts_with(root)) {
        if fs::symlink_metadata(ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("应用私有目录经过符号链接，原位置已保留".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(err)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent).map_err(err)?;
    for ancestor in parent.ancestors().take_while(|p| p.starts_with(root)) {
        private_permissions(ancestor, true)?;
    }
    Ok(())
}

pub(super) fn prepare_private_write(path: &Path) -> Result<bool> {
    let roots = private_roots().read().map_err(|_| "凭据存储暂不可用")?;
    if let Some(root) = roots.iter().find(|root| path.starts_with(root)) {
        private_parents(root, path)?;
        return Ok(true);
    }
    Ok(false)
}

fn private_documents(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = vec![];
    collect_documents(root, root, 0, &mut paths)?;
    let backups = root.join("credential-migration-backups");
    match fs::symlink_metadata(&backups) {
        Ok(_) => {
            if !same_physical_path(&backups)? {
                return Err("凭据备份目录经过符号链接，未改写".into());
            }
            collect_documents(&backups, &backups, 0, &mut paths)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(err(error)),
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub(super) fn register(root: &Path, isolated: bool) -> Result<()> {
    let validation = std::env::args().any(|arg| arg == "--pilot-os-credentials");
    let synthetic_legacy =
        isolated && std::env::var("XWX_DECK_TEST_SECURE_STORE").as_deref() == Ok("1");
    let private_fixture =
        isolated && std::env::var("XWX_DECK_TEST_PRIVATE_STORE").as_deref() == Ok("1");
    let migrate_synthetic =
        isolated && std::env::var("XWX_DECK_TEST_MIGRATE_PRIVATE_STORE").as_deref() == Ok("1");
    if validation || synthetic_legacy && !migrate_synthetic && !private_fixture {
        return register_legacy(root, isolated);
    }
    private_permissions(root, true)?;
    let completed = raw(&root.join(PRIVATE_MARKER))?
        .map(|b| {
            serde_json::from_slice::<Value>(&b).map_err(|_| "私有文件存储记录损坏，原数据已保留")
        })
        .transpose()?;
    if completed
        .as_ref()
        .is_some_and(|v| v["version"] != 1 || v["mode"] != "private-files")
    {
        return Err("私有文件存储记录版本无效，原数据已保留".into());
    }
    let paths = private_documents(root)?;
    let mut encrypted = false;
    for path in &paths {
        let bytes = raw(path)?.ok_or("凭据文件发生变化")?;
        let source = std::str::from_utf8(&bytes).map_err(|_| "原凭据配置不是 UTF-8，未覆盖")?;
        encrypted |= envelope(source).is_some();
    }
    if encrypted {
        if completed.is_some() {
            return Err(
                "已迁移目录中发现旧加密文件，请恢复匹配的备份；未覆盖或重新访问钥匙串".into(),
            );
        }
        // No new key is created when a legacy document exists: metadata and its original key are required.
        let metadata = raw(&root.join("native-credential-vault.json"))?
            .ok_or("旧加密凭据缺少存储记录，原文件已保留")?;
        let record: Value = serde_json::from_slice(&metadata).map_err(|_| "旧凭据存储记录损坏")?;
        if !(record["mode"] == "platform" && !isolated
            || record["mode"] == "isolated-simulation" && migrate_synthetic && synthetic_legacy)
        {
            return Err("旧凭据模式不匹配，原数据已保留".into());
        }
        register_legacy(root, isolated)?;
        for scope in registry()
            .write()
            .map_err(|_| "凭据存储暂不可用")?
            .iter_mut()
            .filter(|s| s.root == root)
        {
            scope.encrypt = false;
        }
    }
    private_roots()
        .write()
        .map_err(|_| "凭据存储暂不可用")?
        .push(root.into());
    Ok(())
}

fn migrate_private_files(root: &Path) -> Result<()> {
    // Authenticate every legacy file before replacing the first one. A retry can
    // resume a partially completed migration using the untouched original key.
    let mut documents = vec![];
    for path in private_documents(root)? {
        let before = Zeroizing::new(raw(&path)?.ok_or("凭据迁移源发生变化")?);
        let source = std::str::from_utf8(&before).map_err(|_| "原凭据配置不是 UTF-8")?;
        let plaintext = Zeroizing::new(decode(&path, source.into())?);
        let encrypted = envelope(source).is_some();
        documents.push((path, before, plaintext, encrypted));
    }
    // Check every intended stage before replacing any document. A known foreign
    // stage must not leave a partially converted directory on the next launch.
    let mut stages = vec![];
    let marker = root.join(PRIVATE_MARKER);
    if raw(&marker)?.is_none() {
        stages.push(marker.with_extension("pilot-tmp"));
    }
    for (path, _, _, encrypted) in &documents {
        if !encrypted {
            continue;
        }
        stages.push(path.with_extension("pilot-tmp"));
        let backup = root
            .join("credential-private-migration-originals")
            .join(path.strip_prefix(root).map_err(err)?);
        match fs::symlink_metadata(&backup) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                stages.push(backup.with_extension("pilot-tmp"));
            }
            Err(_) => return Err("无法检查迁移备份，原目录已保留".into()),
        }
    }
    for stage in stages {
        match fs::symlink_metadata(&stage) {
            Ok(_) => return Err("临时文件已存在，保留现场".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查迁移临时文件，原目录已保留".into()),
        }
    }
    for (path, before, plaintext, encrypted) in &documents {
        private_parents(root, path)?;
        private_permissions(path, false)?;
        if !encrypted {
            continue;
        }
        let backup = root
            .join("credential-private-migration-originals")
            .join(path.strip_prefix(root).map_err(err)?);
        private_parents(root, &backup)?;
        if let Some(saved) = raw(&backup)? {
            if saved.as_slice() != before.as_slice() {
                return Err("旧密文备份与迁移源不一致，未覆盖".into());
            }
        } else {
            write(&backup, std::str::from_utf8(before).map_err(err)?)?;
        }
        if raw(path)?.as_ref() != Some(before.as_ref()) {
            return Err("凭据在迁移期间被修改，已保留最新文件".into());
        }
        write_checked(path, plaintext, plaintext)?;
        if raw(path)?.as_deref() != Some(plaintext.as_bytes()) {
            return Err("私有凭据回读失败，已保留原密文备份".into());
        }
    }
    let marker = root.join(PRIVATE_MARKER);
    if raw(&marker)?.is_none() {
        write(&marker, r#"{"version":1,"mode":"private-files"}"#)?;
    }
    private_permissions(&marker, false)?;
    // Drop the recovered OS master key: all routine reads and writes now use files.
    registry()
        .write()
        .map_err(|_| "凭据存储暂不可用")?
        .retain(|s| s.root != root);
    Ok(())
}
fn register_legacy(root: &Path, isolated: bool) -> Result<()> {
    let simulation = isolated && std::env::var("XWX_DECK_TEST_SECURE_STORE").as_deref() == Ok("1");
    let validation = std::env::args().any(|arg| arg == "--pilot-os-credentials");
    if validation && (!isolated || simulation) {
        return Err("系统凭据验证只允许独立隔离目录，不能同时使用模拟密钥".into());
    }
    if raw(&root.join(PRIVATE_MARKER))?.is_some() {
        return Err("此目录已使用私有文件存储，不能重新启用旧加密模式".into());
    }
    let metadata = root.join("native-credential-vault.json");
    let existing = raw(&metadata)?;
    // Legacy vault fixtures contain synthetic credentials and never touch the
    // user's Keychain. Only explicit diagnostics opt into this old format.
    if isolated && !simulation && !validation {
        if existing.is_some() {
            return Err("此目录已启用安全存储；请使用原凭据模式重启，拒绝降级为明文测试".into());
        }
        return Ok(());
    }
    let service = if validation {
        VALIDATION_SERVICE
    } else {
        SERVICE
    };
    if registry()
        .read()
        .map_err(|_| "安全存储不可用")?
        .iter()
        .any(|s| s.root == root && s.service == service)
    {
        return Ok(());
    }
    let record = existing
        .as_ref()
        .map(|b| serde_json::from_slice::<Value>(b).map_err(|_| "安全存储元数据损坏，原数据已保留"))
        .transpose()?;
    let mode = if simulation {
        "isolated-simulation"
    } else if validation {
        "isolated-platform"
    } else {
        "platform"
    };
    let id = if let Some(record) = &record {
        if record["version"] != 1
            || record["mode"] != mode
            || record["service"]
                .as_str()
                .is_some_and(|value| value != service)
            || validation && record["service"] != VALIDATION_SERVICE
        {
            return Err("安全存储模式或版本不匹配，拒绝降级".into());
        }
        let id = text(record, "id");
        if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("安全存储标识无效".into());
        }
        id.to_owned()
    } else {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| "无法创建安全存储标识")?;
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };
    let key = if simulation {
        let path = root.join("native-test-vault-key.bin");
        if let Some(bytes) = raw(&path)? {
            bytes
        } else {
            if record.is_some() {
                return Err("测试密钥缺失，未重置或覆盖加密配置".into());
            }
            let mut key = vec![0; 32];
            getrandom::fill(&mut key).map_err(|_| "无法生成测试密钥")?;
            raw_write_new(&path, &key)?;
            key
        }
    } else {
        platform_key_for(service, &id, record.is_none())?
    };
    if key.len() != 32 {
        return Err("系统凭据密钥长度无效，原数据已保留".into());
    }
    if record.is_none() {
        raw_write_new(
            &metadata,
            serde_json::to_string(&json!({"version":1,"id":id,"mode":mode,"service":service}))
                .map_err(err)?
                .as_bytes(),
        )?;
    }
    registry()
        .write()
        .map_err(|_| "安全存储不可用")?
        .push(Scope {
            root: root.into(),
            id,
            service,
            key: Zeroizing::new(key),
            encrypt: true,
        });
    Ok(())
}
/// Upgrade private storage before loading settings. Explicit legacy diagnostics
/// still seal their synthetic documents and preserve authenticated backups.
pub(super) fn migrate_documents(root: &Path) -> Result<()> {
    cleanup_cli_homes(root)?;
    if private_roots()
        .read()
        .map_err(|_| "凭据存储暂不可用")?
        .contains(&root.to_path_buf())
    {
        return migrate_private_files(root);
    }
    if !registry()
        .read()
        .map_err(|_| "安全存储不可用")?
        .iter()
        .any(|s| s.root == root)
    {
        return Ok(());
    }
    let mut paths = Vec::new();
    collect_documents(root, root, 0, &mut paths)?;
    paths.sort();
    for path in paths {
        let relative = path
            .strip_prefix(root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        if !protected(&relative) {
            continue;
        }
        let bytes = raw(&path)?.ok_or("迁移文件发生变化，原目录已保留")?;
        let source =
            std::str::from_utf8(&bytes).map_err(|_| "原凭据配置不是 UTF-8，未迁移或覆盖")?;
        if envelope(source).is_some() {
            decode(&path, source.into())?;
            continue;
        }
        let backup = root.join("credential-migration-backups").join(&relative);
        for parent in backup.ancestors().take_while(|p| p.starts_with(root)) {
            if fs::symlink_metadata(parent).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("凭据备份目录经过符号链接，未覆盖原文件".into());
            }
        }
        fs::create_dir_all(backup.parent().ok_or("凭据备份路径无效")?).map_err(err)?;
        if raw(&backup)?.is_none() {
            write(&backup, source)?;
        }
        let original = read(&backup)?.ok_or("凭据迁移备份缺失，未覆盖原文件")?;
        // No raw token, cookie, or credential is included in this journal.
        let ledger = root.join("credential-migration.json");
        let mut state = read(&ledger)?
            .map(|s| {
                serde_json::from_str::<Value>(&s).map_err(|_| "凭据迁移记录损坏，已保留".to_owned())
            })
            .transpose()?
            .unwrap_or(json!({"version":1,"documents":{}}));
        if state["version"] != 1 || !state["documents"].is_object() {
            return Err("凭据迁移记录版本无效，未覆盖".into());
        }
        state["documents"][&relative] = json!({"beforeSha256":storage::digest(&bytes),"backupSha256":storage::digest(original.as_bytes()),"backup":backup,"completed":false});
        write(&ledger, &state.to_string())?;
        write_checked(&path, source, source)?;
        state["documents"][&relative]["completed"] = json!(true);
        write(&ledger, &state.to_string())?;
    }
    Ok(())
}
fn collect_documents(
    root: &Path,
    directory: &Path,
    depth: usize,
    paths: &mut Vec<PathBuf>,
) -> Result<()> {
    if depth > 2 {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let kind = entry.file_type().map_err(err)?;
        let path = entry.path();
        let name = path
            .strip_prefix(root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        if kind.is_symlink() {
            if protected(&name)
                || name == "codex"
                || name == "gateway"
                || name == "trace-client-backups"
                || name == "grok-accounts"
                || name == "claude-subscription-homes"
                || name.starts_with("reset-backup-")
                || name.starts_with("grok-accounts/grok-")
                || name.starts_with("claude-subscription-homes/claude-")
            {
                return Err("凭据路径是符号链接，原文件已保留".into());
            }
            continue;
        }
        if kind.is_file() && protected(&name) {
            paths.push(path);
        } else if kind.is_dir()
            && (depth == 0
                && (name == "codex"
                    || name == "gateway"
                    || name == "trace-client-backups"
                    || name == "grok-accounts"
                    || name == "claude-subscription-homes"
                    || name.starts_with("reset-backup-"))
                || depth == 1
                    && (name.starts_with("grok-accounts/grok-")
                        || name.starts_with("claude-subscription-homes/claude-")))
        {
            collect_documents(root, &path, depth + 1, paths)?;
        }
        if paths.len() > 10_000 {
            return Err("凭据文件超过迁移上限，未继续写入".into());
        }
    }
    Ok(())
}
static CLI_LEDGER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Official CLIs consume ordinary JSON only while their isolated process runs.
/// These temporary homes are outside the application data tree and removed on
/// success, failure, timeout and cancellation without touching the user's CLI.
pub(super) struct CliHome {
    pub path: PathBuf,
    root: PathBuf,
    lease: Option<fs::File>,
    completed: bool,
}
#[cfg(unix)]
unsafe extern "C" {
    // POSIX fcntl is variadic. Apple ARM64 passes its final argument on the
    // stack, so declaring a fixed third argument can leave CLOEXEC unchanged.
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

#[cfg(unix)]
fn clear_cli_lease_cloexec(fd: i32) -> std::io::Result<()> {
    let flags = unsafe { fcntl(fd, 1) }; // F_GETFD
    if flags < 0 || unsafe { fcntl(fd, 2, flags & !1) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let inherited = unsafe { fcntl(fd, 1) };
    if inherited < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if inherited & 1 != 0 {
        // The pre-exec callback must not allocate or acquire application locks.
        return Err(std::io::Error::from_raw_os_error(22)); // EINVAL
    }
    Ok(())
}

impl CliHome {
    pub fn create(root: &Path) -> Result<Self> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "无法创建临时授权目录")?;
        let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = fs::canonicalize(std::env::temp_dir())
            .map_err(err)?
            .join(format!("xwxdeck-cli-{name}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .map_err(err)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&path).map_err(err)?;
        let lease_path = path.join(".xwxdeck-cli-lease");
        raw_write_new(&lease_path, b"")?;
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
            .map_err(err)?;
        lease.try_lock().map_err(|_| "无法锁定临时授权目录")?;
        let home = Self {
            path,
            root: root.into(),
            lease: Some(lease),
            completed: true,
        };
        raw_write_new(
            &home.path.join(".xwxdeck-cli-owner"),
            storage::digest(root.to_string_lossy().as_bytes()).as_bytes(),
        )?;
        // Cancellation can clean one home while a new login registers another.
        let _ledger = CLI_LEDGER_LOCK.lock().map_err(|_| "临时授权账本暂不可用")?;
        let ledger = root.join("native-cli-work.json");
        let before = read(&ledger)?.unwrap_or_default();
        let mut jobs: Vec<PathBuf> = if before.is_empty() {
            vec![]
        } else {
            serde_json::from_str(&before).map_err(|_| "临时授权目录账本损坏，未覆盖")?
        };
        jobs.push(home.path.clone());
        write_checked(
            &ledger,
            &before,
            &serde_json::to_string(&jobs).map_err(err)?,
        )?;
        Ok(home)
    }
    pub fn put(&self, name: &str, value: &str) -> Result<()> {
        if !matches!(name, "auth.json" | ".credentials.json") {
            return Err("无效临时凭据文件名".into());
        }
        raw_write_new(&self.path.join(name), value.as_bytes())
    }
    /// Streaming app-server transport with the same inherited lease/recovery
    /// contract as one-shot CLI refreshes.
    pub fn spawn(
        &mut self,
        command: &mut tokio::process::Command,
    ) -> Result<tokio::process::Child> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = self.lease.as_ref().ok_or("临时授权租约已释放")?.as_raw_fd();
            unsafe {
                command.pre_exec(move || clear_cli_lease_cloexec(fd));
            }
        }
        let child = command
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "无法启动官方账号服务")?;
        self.completed = false;
        Ok(child)
    }
    pub fn exited(&mut self) {
        self.completed = true;
    }
    pub async fn status(
        &mut self,
        command: &mut tokio::process::Command,
        timeout: Duration,
    ) -> Result<std::process::ExitStatus> {
        // The child keeps the same open-file-description lock across exec.
        // A killed manager cannot make startup mistake a live CLI for garbage.
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = self.lease.as_ref().ok_or("临时授权租约已释放")?.as_raw_fd();
            unsafe {
                command.pre_exec(move || clear_cli_lease_cloexec(fd));
            }
        }
        let mut child = command
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "无法启动订阅刷新")?;
        self.completed = false;
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(result) => {
                let status = result.map_err(|_| "无法等待订阅刷新")?;
                self.completed = true;
                Ok(status)
            }
            Err(_) => {
                let _ = child.start_kill();
                // Keep the ledger if termination cannot be observed. On Unix
                // the inherited lease also protects still-running descendants.
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                Err("订阅刷新超时".into())
            }
        }
    }
}
impl Drop for CliHome {
    fn drop(&mut self) {
        drop(self.lease.take());
        #[cfg(not(unix))]
        if !self.completed {
            return;
        }
        let Ok(Some(lease)) = cli_home_lease(&self.path, &self.root) else {
            return;
        };
        if fs::remove_dir_all(&self.path).is_err() {
            return;
        }
        drop(lease);
        let Ok(_ledger) = CLI_LEDGER_LOCK.lock() else {
            return;
        };
        let ledger = self.root.join("native-cli-work.json");
        if let Ok(Some(before)) = read(&ledger) {
            if let Ok(mut jobs) = serde_json::from_str::<Vec<PathBuf>>(&before) {
                jobs.retain(|p| p != &self.path);
                if let Ok(after) = serde_json::to_string(&jobs) {
                    let _ = write_checked(&ledger, &before, &after);
                }
            }
        }
    }
}
fn cli_home_lease(path: &Path, root: &Path) -> Result<Option<fs::File>> {
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(err)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let valid = name
        .strip_prefix("xwxdeck-cli-")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()));
    if !valid
        || !same_physical_path(path)?
        || path
            .parent()
            .map(fs::canonicalize)
            .transpose()
            .map_err(err)?
            .as_ref()
            != Some(&temp)
    {
        return Err("临时授权恢复路径无效，未删除任何外部目录".into());
    }
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("临时授权恢复目录异常，已保留".into());
    }
    let owner = storage::digest(root.to_string_lossy().as_bytes());
    if raw(&path.join(".xwxdeck-cli-owner"))?.as_deref() != Some(owner.as_bytes()) {
        return Err("临时授权恢复所有权冲突，已保留".into());
    }
    let lock = path.join(".xwxdeck-cli-lease");
    if !fs::symlink_metadata(&lock)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Err(
            "旧版临时授权目录缺少进程租约，已保留；请确认相关 CLI 已退出后处理账本中的该目录"
                .into(),
        );
    }
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock)
        .map_err(err)?;
    match lease.try_lock() {
        Ok(()) => Ok(Some(lease)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn cleanup_cli_homes(root: &Path) -> Result<()> {
    let _ledger = CLI_LEDGER_LOCK.lock().map_err(|_| "临时授权账本暂不可用")?;
    let ledger = root.join("native-cli-work.json");
    let Some(before) = read(&ledger)? else {
        return Ok(());
    };
    let jobs: Vec<PathBuf> =
        serde_json::from_str(&before).map_err(|_| "临时授权目录账本损坏，原记录已保留")?;
    if jobs.len() > 64 {
        return Err("临时授权目录账本超出上限".into());
    }
    #[cfg(unix)]
    let mut ready: Vec<(PathBuf, fs::File)> = vec![];
    #[cfg(not(unix))]
    let ready: Vec<(PathBuf, fs::File)> = vec![];
    let mut retained = vec![];
    // Validate every ownership marker before deleting the first directory.
    for path in jobs {
        if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            continue;
        }
        let lease = cli_home_lease(&path, root)?;
        #[cfg(unix)]
        match lease {
            Some(lease) => ready.push((path, lease)),
            None => retained.push(path),
        }
        #[cfg(not(unix))]
        {
            drop(lease);
            retained.push(path);
        }
    }
    for (path, lease) in ready {
        fs::remove_dir_all(path).map_err(err)?;
        drop(lease);
    }
    write_checked(
        &ledger,
        &before,
        &serde_json::to_string(&retained).map_err(err)?,
    )
}
pub(super) fn assert_cli_homes_idle(root: &Path) -> Result<()> {
    let _ledger = CLI_LEDGER_LOCK.lock().map_err(|_| "临时授权账本暂不可用")?;
    let Some(source) = read(&root.join("native-cli-work.json"))? else {
        return Ok(());
    };
    let jobs: Vec<PathBuf> =
        serde_json::from_str(&source).map_err(|_| "临时授权恢复记录损坏，未重置")?;
    if jobs.len() > 64 {
        return Err("临时授权恢复记录超出上限，未重置".into());
    }
    for path in jobs {
        if fs::symlink_metadata(&path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            continue;
        }
        if cli_home_lease(&path, root)?.is_none() {
            return Err("授权 CLI 仍在使用临时目录，请结束授权后重新重置；原数据保留".into());
        }
        #[cfg(not(unix))]
        return Err("此平台尚未验证授权子进程退出，临时目录与恢复记录保留".into());
    }
    Ok(())
}
pub(super) fn export_backup(
    root: &Path,
    destination: &Path,
    original: bool,
    isolated: bool,
) -> Result<Value> {
    if !root.is_absolute()
        || !same_physical_path(root)?
        || !destination.is_absolute()
        || destination.starts_with(root)
        || destination
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err("备份导出必须使用独立的绝对路径，原目录未改写".into());
    }
    let parent = destination.parent().ok_or("导出目录无效")?;
    if !same_physical_path(parent)? || fs::symlink_metadata(destination).is_ok() {
        return Err("导出目录已存在或经过符号链接，未覆盖".into());
    }
    if raw(&root.join(PRIVATE_MARKER))?.is_none()
        && raw(&root.join("native-credential-vault.json"))?.is_none()
    {
        return Err("没有可恢复的凭据存储记录".into());
    }
    let lock_path = root.join("pilot.lock");
    let metadata =
        fs::symlink_metadata(&lock_path).map_err(|_| "缺少原生目录锁记录，未读取凭据")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("原生目录锁不是普通文件，未读取凭据".into());
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(err)?;
    lock.try_lock()
        .map_err(|_| "请先停止并退出原生应用，再导出备份")?;
    register(root, isolated)?;
    let mut paths = vec![];
    collect_documents(root, root, 0, &mut paths)?;
    let mut candidates: std::collections::BTreeMap<String, PathBuf> = paths
        .into_iter()
        .map(|path| {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            (name, path)
        })
        .collect();
    if original {
        let backups = root.join("credential-migration-backups");
        if backups.exists() {
            if !same_physical_path(&backups)? {
                return Err("原始备份目录经过符号链接，未导出".into());
            }
            let mut saved = vec![];
            collect_documents(&backups, &backups, 0, &mut saved)?;
            for path in saved {
                let name = path
                    .strip_prefix(&backups)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                candidates.insert(name, path);
            }
        }
    }
    let mut files = vec![];
    for (relative, source) in candidates {
        for ancestor in source.ancestors().take_while(|p| p.starts_with(root)) {
            if fs::symlink_metadata(ancestor).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("备份读取经过符号链接，原文件已保留".into());
            }
        }
        let raw_bytes = raw(&source)?.ok_or("备份源发生变化")?;
        let value = decode(
            &source,
            String::from_utf8(raw_bytes.clone()).map_err(|_| "凭据备份不是 UTF-8")?,
        )?;
        files.push((relative, source, raw_bytes, Zeroizing::new(value)));
    }
    if files.is_empty() {
        return Err("未发现可导出的凭据配置".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(destination)
            .map_err(err)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(destination).map_err(err)?;
    private_permissions(destination, true)?;
    let result = (|| -> Result<Value> {
        let mut manifest = vec![];
        for (relative, _, _, value) in &files {
            let output = destination.join(relative);
            fs::create_dir_all(output.parent().ok_or("备份路径无效")?).map_err(err)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for parent in output
                    .ancestors()
                    .skip(1)
                    .take_while(|p| p.starts_with(destination))
                {
                    fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(err)?;
                }
            }
            raw_write_new(&output, value.as_bytes())?;
            manifest.push(json!({"path":relative,"size":value.len(),"sha256":storage::digest(value.as_bytes())}));
        }
        for (_, path, before, _) in &files {
            if raw(path)?.as_ref() != Some(before) {
                return Err("导出期间源文件发生变化，请重试；原文件未改写".into());
            }
        }
        let report = json!({"version":1,"mode":if original{"original-before-migration"}else{"current"},"containsPlaintextCredentials":true,"files":manifest});
        raw_write_new(
            &destination.join("credential-backup-manifest.json"),
            serde_json::to_string_pretty(&report)
                .map_err(err)?
                .as_bytes(),
        )?;
        Ok(
            json!({"path":destination,"fileCount":files.len(),"mode":report["mode"],"containsPlaintextCredentials":true}),
        )
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}
#[cfg(target_os = "macos")]
pub(super) fn platform_diagnostic(mode: &str, id: &str, challenge: &str) -> Result<Value> {
    use security_framework::{
        os::macos::keychain::SecKeychain,
        passwords::{delete_generic_password, get_generic_password},
    };
    // This CLI process must fail when the Keychain cannot be accessed. It never
    // opens an authorization dialog or changes another process's UI policy.
    let _interaction =
        SecKeychain::disable_user_interaction().map_err(|_| "无法准备无交互钥匙串自检")?;
    let valid_id = |id: &str| {
        id.strip_prefix("self-test-")
            .is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    let missing = |id: &str| -> Result<()> {
        match get_generic_password(SERVICE, id) {
            Err(error) if error.code() == -25300 => Ok(()),
            Ok(_) => Err("自检条目仍存在，未操作已有账号".into()),
            Err(_) => Err("无法确认自检条目状态，请解锁钥匙串后重试".into()),
        }
    };
    let proof = |id: &str, challenge: &str| -> Result<String> {
        if !valid_id(id)
            || challenge.len() != 64
            || !challenge.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("只允许随机独立自检条目和挑战值，未访问安全存储".into());
        }
        let mut bytes = Zeroizing::new(platform_key(id, false)?);
        if bytes.len() != 32 {
            return Err("自检密钥长度无效".into());
        }
        bytes.extend_from_slice(challenge.as_bytes());
        Ok(storage::digest(&bytes))
    };
    match mode {
        "probe" => return Ok(json!({"proof":proof(id, challenge)?})),
        "cleanup" => {
            if !valid_id(id) {
                return Err("只允许清理独立自检条目，未访问已有凭据".into());
            }
            match delete_generic_password(SERVICE, id) {
                Ok(()) => {}
                Err(error) if error.code() == -25300 => {}
                Err(_) => return Err("无法清理自检条目，请解锁钥匙串后重试".into()),
            }
            missing(id)?;
            return Ok(json!({"cleaned":true,"missingAfterDelete":true}));
        }
        "self-test" => {}
        _ => return Err("未知安全存储诊断操作".into()),
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "系统随机数不可用")?;
    let id = format!(
        "self-test-{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    // Only this non-secret random identity is reported, so the harness can
    // clean its own synthetic entry after an abnormal diagnostic process exit.
    println!("{}", json!({"event":"credential-probe","probeId":id}));
    missing(&id)?; // Never let the platform's upsert overwrite an existing item.
    struct ProbeCleanup(Option<String>);
    impl Drop for ProbeCleanup {
        fn drop(&mut self) {
            if let Some(id) = &self.0 {
                let _ = security_framework::passwords::delete_generic_password(SERVICE, id);
            }
        }
    }
    let mut cleanup = ProbeCleanup(Some(id.clone()));
    let key = Zeroizing::new(platform_key(&id, true)?);
    if key.len() != 32 {
        return Err("自检密钥长度无效".into());
    }
    let challenge = storage::digest(&random);
    let expected = {
        let mut bytes = Zeroizing::new(key.to_vec());
        bytes.extend_from_slice(challenge.as_bytes());
        storage::digest(&bytes)
    };
    if proof(&id, &challenge)? != expected {
        return Err("写入后的安全存储密钥校验不一致".into());
    }
    let executable = std::env::current_exe().map_err(|_| "无法定位安全存储自检程序")?;
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(err)?
        .block_on(async {
            let mut command = tokio::process::Command::new(executable);
            command
                .args([
                    "--credential-store-diagnostic",
                    "probe",
                    "--probe-id",
                    &id,
                    "--probe-challenge",
                    &challenge,
                ])
                .kill_on_drop(true);
            tokio::time::timeout(Duration::from_secs(10), command.output())
                .await
                .map_err(|_| "跨进程安全存储自检超时".to_owned())?
                .map_err(|_| "无法运行安全存储自检子进程".to_owned())
        })?;
    if !output.status.success() {
        return Err("跨进程读取钥匙串失败，请解锁并检查自检程序授权后重试；已有账号未访问".into());
    }
    let received: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "安全存储子进程返回无效结果")?;
    if received["proof"] != expected {
        return Err("跨进程安全存储校验不一致".into());
    }
    delete_generic_password(SERVICE, &id).map_err(|_| "无法清理自检条目，请解锁钥匙串后重试")?;
    cleanup.0 = None;
    missing(&id)?;
    Ok(
        json!({"passed":true,"platform":"macos-keychain","syntheticOnly":true,"write":true,"crossProcessRead":true,"delete":true,"missingAfterDelete":true,"existingAccountsAccessed":false}),
    )
}
#[cfg(not(target_os = "macos"))]
pub(super) fn platform_diagnostic(_mode: &str, _id: &str, _challenge: &str) -> Result<Value> {
    Err("当前平台真实凭据存储自检尚未验证，未操作已有凭据".into())
}
#[cfg(target_os = "macos")]
fn platform_key(id: &str, create: bool) -> Result<Vec<u8>> {
    platform_key_for(SERVICE, id, create)
}
#[cfg(target_os = "macos")]
fn platform_key_for(service: &str, id: &str, create: bool) -> Result<Vec<u8>> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    match get_generic_password(service, id) {
        Ok(key) => Ok(key),
        Err(e) if e.code() == -25300 && create => {
            let mut key = vec![0; 32];
            getrandom::fill(&mut key).map_err(|_| "无法生成安全存储密钥")?;
            set_generic_password(service, id, &key)
                .map_err(|_| "无法保存到 macOS 钥匙串，请解锁钥匙串后重试；原文件已保留")?;
            Ok(key)
        }
        Err(_) => {
            Err("无法读取 macOS 钥匙串，请解锁或恢复原凭据后重试；未生成替代密钥或覆盖配置".into())
        }
    }
}
#[cfg(target_os = "windows")]
fn platform_key_for(service: &str, id: &str, create: bool) -> Result<Vec<u8>> {
    // Win32 CREDENTIALW layout and ownership follow the platform API:
    // https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw
    // https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw
    use std::ptr::{null_mut, write_bytes};
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *mut u16,
        comment: *mut u16,
        written: FileTime,
        size: u32,
        blob: *mut u8,
        persist: u32,
        count: u32,
        attributes: *mut std::ffi::c_void,
        alias: *mut u16,
        user: *mut u16,
    }
    #[link(name = "Advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, out: *mut *mut Credential) -> i32;
        fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        fn CredFree(buffer: *mut std::ffi::c_void);
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }
    let mut target = format!("{service}/{id}")
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut credential: *mut Credential = null_mut();
    unsafe {
        if CredReadW(target.as_ptr(), 1, 0, &mut credential) != 0 {
            if credential.is_null() {
                return Err("Windows 安全存储返回空记录，未覆盖配置".into());
            }
            let item = &*credential;
            if item.size != 32 || item.blob.is_null() {
                CredFree(credential.cast());
                return Err("Windows 安全存储密钥长度无效，原文件已保留".into());
            }
            let key = std::slice::from_raw_parts(item.blob, 32).to_vec();
            write_bytes(item.blob, 0, 32);
            CredFree(credential.cast());
            return Ok(key);
        }
        if GetLastError() != 1168 || !create {
            return Err(
                "无法读取 Windows 凭据管理器，请恢复原凭据后重试；未生成替代密钥或覆盖配置".into(),
            );
        }
    }
    let mut key = Zeroizing::new(vec![0; 32]);
    getrandom::fill(&mut key).map_err(|_| "无法生成安全存储密钥")?;
    let record = Credential {
        flags: 0,
        kind: 1,
        target: target.as_mut_ptr(),
        comment: null_mut(),
        written: FileTime { low: 0, high: 0 },
        size: 32,
        blob: key.as_mut_ptr(),
        persist: 2,
        count: 0,
        attributes: null_mut(),
        alias: null_mut(),
        user: null_mut(),
    };
    if unsafe { CredWriteW(&record, 0) } == 0 {
        return Err("无法保存到 Windows 凭据管理器，原文件已保留".into());
    }
    Ok(key.to_vec())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_key_for(_service: &str, _id: &str, _create: bool) -> Result<Vec<u8>> {
    Err("当前平台安全存储适配尚未验证，未写入或降级为明文".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn private_webcrypto_key_survives_restart_and_rejects_corruption() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "deck-webcrypto-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir(&root).unwrap();
        let first = webcrypto_private_key(&root, false, false).unwrap();
        let file = root.join("native-webcrypto-key.json");
        assert_eq!(first.len(), 16);
        assert_eq!(*first, *webcrypto_private_key(&root, false, false).unwrap());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let bad = r#"{"version":1,"key":"AAAA"}"#;
        fs::write(&file, bad).unwrap();
        assert!(webcrypto_private_key(&root, true, true).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), bad);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn invalid_cli_lease_descriptor_cannot_silently_pass_exec_admission() {
        assert!(clear_cli_lease_cloexec(-1).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn actual_exec_retains_cli_lease_after_the_parent_home_is_dropped() {
        use std::os::fd::AsRawFd;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!(
            "xwxdeck-cli-exec-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir(&root).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut home = CliHome::create(&root).unwrap();
                let path = home.path.clone();
                let fd = home.lease.as_ref().unwrap().as_raw_fd();
                assert_eq!(
                    unsafe { fcntl(fd, 1) } & 1,
                    1,
                    "the parent descriptor remains CLOEXEC"
                );
                let mut command = tokio::process::Command::new("/bin/cat");
                command
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped());
                let mut child = home.spawn(&mut command).unwrap();
                let mut input = child.stdin.take().unwrap();
                let mut output = child.stdout.take().unwrap();
                input.write_all(b"ready").await.unwrap();
                let mut ready = [0; 5];
                tokio::time::timeout(Duration::from_secs(5), output.read_exact(&mut ready))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(&ready, b"ready", "the child has executed its real program");
                assert_eq!(
                    unsafe { fcntl(fd, 1) } & 1,
                    1,
                    "clearing the child flag does not affect parallel parent spawns"
                );
                drop(home);
                assert!(
                    cli_home_lease(&path, &root).unwrap().is_none(),
                    "the actual exec child still owns its inherited lock"
                );
                cleanup_cli_homes(&root).unwrap();
                assert!(path.is_dir());
                let live: Vec<PathBuf> = serde_json::from_str(
                    &read(&root.join("native-cli-work.json")).unwrap().unwrap(),
                )
                .unwrap();
                assert_eq!(live, vec![path.clone()]);
                drop(input);
                assert!(tokio::time::timeout(Duration::from_secs(5), child.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success());
                cleanup_cli_homes(&root).unwrap();
                assert!(!path.exists());
                assert_eq!(
                    read(&root.join("native-cli-work.json")).unwrap().as_deref(),
                    Some("[]")
                );
            });
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_cli_homes_preserve_every_live_lease_and_cleanup() {
        let root = std::env::temp_dir().join(format!(
            "xwxdeck-cli-ledger-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir(&root).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let home = CliHome::create(&root);
                    let result = home.as_ref().map(|_| ()).map_err(Clone::clone);
                    barrier.wait();
                    barrier.wait();
                    drop(home);
                    result
                })
            })
            .collect();
        barrier.wait();
        barrier.wait();
        let ledger = root.join("native-cli-work.json");
        let live: Vec<PathBuf> =
            serde_json::from_str(&read(&ledger).unwrap().unwrap_or_else(|| "[]".into())).unwrap();
        let live_paths_exist = live
            .iter()
            .all(|path| path.join(".xwxdeck-cli-lease").exists());
        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let remaining: Vec<PathBuf> =
            serde_json::from_str(&read(&ledger).unwrap().unwrap_or_else(|| "[]".into())).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        assert_eq!(live.len(), 8, "every active home must remain recoverable");
        assert!(live_paths_exist);
        assert!(
            remaining.is_empty(),
            "completed homes must all leave the ledger"
        );
    }
    #[test]
    fn nonce_authentication_and_path_binding() {
        let mut key = vec![0; 32];
        getrandom::fill(&mut key).unwrap();
        let root = PathBuf::from(format!("/xwxdeck-vault-test-{}", millis()));
        registry().write().unwrap().push(Scope {
            root: root.clone(),
            id: "fixture".into(),
            service: SERVICE,
            key: Zeroizing::new(key),
            encrypt: true,
        });
        let path = root.join("settings.json");
        let first = encode(&path, "SECRET-FIXTURE").unwrap();
        let second = encode(&path, "SECRET-FIXTURE").unwrap();
        assert_ne!(first, second);
        assert!(!first.contains("SECRET-FIXTURE"));
        assert_eq!(decode(&path, first.clone()).unwrap(), "SECRET-FIXTURE");
        assert!(decode(&root.join("subscription-accounts.json"), first.clone()).is_err());
        let mut corrupt: Value = serde_json::from_str(&first).unwrap();
        corrupt["ciphertext"] = json!("AAAAAAAAAAAAAAAAAAAAAAAA");
        assert!(decode(&path, corrupt.to_string()).is_err());
    }
}
