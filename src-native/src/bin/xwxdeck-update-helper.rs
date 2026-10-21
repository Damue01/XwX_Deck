// Reuse the verified update worker without linking the desktop entrypoint or UI.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../macos_update.rs"]
mod macos_update;

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(macos_update::worker().unwrap_or(1));
    #[cfg(not(target_os = "macos"))]
    std::process::exit(1);
}
